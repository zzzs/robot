import { IsString, IsNotEmpty } from 'class-validator';

export class ChatMessageDto {
  @IsString()
  @IsNotEmpty()
  sessionId: string;

  @IsString()
  @IsNotEmpty()
  message: string;
}
